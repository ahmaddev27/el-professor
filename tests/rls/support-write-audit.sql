/*
  Support-session write audit (plan 3.B, slice 3.4c, migration 20260920110000):
  every row a platform account writes inside a support session leaves exactly one
  audit row, and nobody else's writes leave any.

  Runs after the files before it, against the same throwaway database, as
  supabase_admin. Every check raises on failure; a silent run is a pass. The
  whole file is one transaction rolled back at the end, so the files after it
  see the database as the seeds left it. That includes the temporary policy of
  section 8 and the test trigger of section 9, which are also dropped where they
  are used.

  What is covered, in order:

    1. shape         the audit trigger sits exactly where the refusal trigger
                     sits, is an enabled AFTER ROW trigger gated on the flag,
                     and nothing it calls is executable by an API role
    2. members       an ordinary member's insert, update and delete leave no
                     audit row at all, and clear a flag they find set
    3. support       one row per written row — insert, update, a multi-row
                     update, a delete and a write that changes nothing — with
                     the company, the row, the actor, its role, its session, the
                     context and its reason
    4. what is kept  changed columns only; pay, identifiers and notes as a
                     marker; long values and JSON documents as a size
    5. view          a view context's write is still refused (3.4a) and leaves
                     no support row
    6. elsewhere     a support session's write outside its company is refused
                     by RLS and leaves no row
   6b. the shell     company_settings and user_profiles (20260921110000, 3.13a):
                     no context and a view context write neither; a support
                     session writes its company's rows and each is recorded;
                     its own profile row, another company's settings and an
                     audited RPC's write elsewhere are not recorded; a member's
                     statement clears the binding
    7. planning      apply_monthly_planning_run and replace_monthly_planning_run:
                     T + E + 2 and D + T + E + 3 rows, the trips' rows carrying
                     the assignment columns only
    8. trips         protect_fahrtenbuch_immutable_fields refuses before the
                     audit could run; a mutable change is recorded alone
    9. one account   the flag belongs to the account that armed it; a forged one
                     makes the write fail rather than write a row in another
                     account's name
   10. cascades      a delete's cascade inside the company is recorded row by
                     row; a write after the session vanished, or after it
                     ended before the transaction's first write, is refused,
                     never let through; a company's hard delete is refused
                     before any cascade while a context is open, and an owner
                     with no context still deletes it, recording nothing
   11. mid-call      a session that ends while its writes are still running
                     keeps them recorded
   12. the door      platform_audit_record cannot forge these rows
   13. the file      every support-write row written here names the owner, its
                     session and its context

  What is deliberately not here: storage.objects (no row history, and its
  policies belong to another slice), and timing — the kit measures nothing, and
  the cost of the planning path has to be measured on staging. company_settings
  and user_profiles were excluded until 20260921110000 gave their platform
  writes a company from the support session; section 6b covers them.
*/

\set ON_ERROR_STOP on

BEGIN;

-- ─── GoTrue stubs (as in platform-contexts.sql) ─────────────────────────────

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

CREATE OR REPLACE FUNCTION _sw_ok(p_desc text, p_ok boolean) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  -- NULL is a failure: a check that could not be evaluated proved nothing.
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: %', p_desc;
  END IF;
  RAISE NOTICE 'ok  %', p_desc;
END $$;

CREATE OR REPLACE FUNCTION _sw_id(p_what text) RETURNS uuid
LANGUAGE sql IMMUTABLE AS $$ SELECT md5('sw:' || p_what)::uuid $$;

CREATE OR REPLACE FUNCTION _sw_reset() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE 'SET LOCAL ROLE NONE';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  PERFORM set_config('request.jwt.claim.session_id', '', true);
  PERFORM set_config('request.jwt.claim.amr', '', true);
END $$;

/*
  Become a signed-in caller with a password sign-in and, when given, the
  sign-in session a context is answered to. The singular claims, as in
  platform-contexts.sql: app_private.jwt_subject_source() reads the amr out of
  the same form the subject came from.
*/
CREATE OR REPLACE FUNCTION _sw_as(p_user uuid, p_session uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM _sw_reset();
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config('request.jwt.claim.amr', '[{"method": "password", "timestamp": 1789416052}]', true);
  IF p_session IS NOT NULL THEN
    PERFORM set_config('request.jwt.claim.session_id', p_session::text, true);
  END IF;
  EXECUTE 'SET LOCAL ROLE authenticated';
END $$;

/*
  Run p_sql as that caller in a subtransaction that is always rolled back, and
  return the scalar it answered, `rows N` for a statement without a result, or
  `ERR <sqlstate> <message>`. Nothing it writes survives — audit rows included —
  so a check whose subject is the audit row makes its write outside this.
*/
CREATE OR REPLACE FUNCTION _sw_try(p_user uuid, p_session uuid, p_sql text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_out   text;
  v_rows  bigint;
  v_state text;
  v_msg   text;
BEGIN
  BEGIN
    PERFORM _sw_as(p_user, p_session);
    IF p_sql ~* '^\s*(select|with)' THEN
      EXECUTE p_sql INTO v_out;
      v_out := coalesce(v_out, '<null>');
    ELSE
      EXECUTE p_sql;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_out := 'rows ' || v_rows;
    END IF;
    RAISE EXCEPTION USING ERRCODE = 'ZZ008', MESSAGE = v_out;
  EXCEPTION
    WHEN SQLSTATE 'ZZ008' THEN
      v_out := SQLERRM;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      v_out := 'ERR ' || v_state || ' ' || v_msg;
  END;
  PERFORM _sw_reset();
  RETURN v_out;
END $$;

/** The audit log's high-water mark, so each check counts only its own rows. */
CREATE OR REPLACE FUNCTION _sw_mark() RETURNS bigint
LANGUAGE sql AS $$ SELECT coalesce(max(l.id), 0) FROM app_private.platform_audit_log l $$;

/** Support-write rows after a mark, for one action or for all of them. */
CREATE OR REPLACE FUNCTION _sw_rows(p_since bigint, p_action text DEFAULT NULL) RETURNS bigint
LANGUAGE sql AS $$
  SELECT count(*)
    FROM app_private.platform_audit_log l
   WHERE l.id > p_since
     AND l.action ~ '^support_write\.'
     AND (p_action IS NULL OR l.action = p_action)
$$;

/** The keys of a jsonb object, sorted, for an exact comparison. */
CREATE OR REPLACE FUNCTION _sw_keys(p_obj jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(array_agg(t.k ORDER BY t.k), '{}'::text[]) FROM jsonb_object_keys(p_obj) AS t(k)
$$;

/** The owner's one open support context. One per staff member, by the index. */
CREATE OR REPLACE FUNCTION _sw_owner_context() RETURNS uuid
LANGUAGE sql AS $$
  SELECT c.id FROM app_private.platform_company_contexts c
   WHERE c.staff_user_id = _sw_id('user:owner') AND c.mode = 'support' AND c.closed_at IS NULL
$$;

-- ─── principals and data ────────────────────────────────────────────────────
--
-- Two healthy companies, an administrator of the first, and two platform
-- accounts: an owner, who opens a support session, and a read_only account,
-- which may only look. The platform accounts carry no company and the text role
-- `viewer`, so anything they write is the session's doing.

INSERT INTO companies (id, name, slug, approval_status, status, plan, subscription_status)
VALUES
  (_sw_id('company:x'), 'SW X', 'sw-x', 'approved', 'active', 'basic', 'active'),
  (_sw_id('company:y'), 'SW Y', 'sw-y', 'approved', 'active', 'basic', 'active')
ON CONFLICT (id) DO NOTHING;

-- owner-view is a second owner, for section 6b: every capability `owner`
-- holds, and a *view* context instead of a support session. member-x is a
-- plain member of company X whose profile section 6b writes.
INSERT INTO auth.users (id, email, email_confirmed_at)
SELECT _sw_id('user:' || v.who), 'sw-' || v.who || '@test.invalid', now()
FROM (VALUES ('admin-x'), ('owner'), ('readonly'), ('owner-view'), ('member-x')) AS v(who)
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_profiles (user_id, email, full_name, role, role_id, company_id, status)
SELECT _sw_id('user:' || v.who), 'sw-' || v.who || '@test.invalid', 'SW ' || v.who, v.role,
       (SELECT r.id FROM roles r WHERE r.name = v.role AND r.company_id IS NULL),
       v.company_id, 'active'
FROM (VALUES
  ('admin-x',    'admin',  _sw_id('company:x')),
  ('owner',      'viewer', NULL::uuid),
  ('readonly',   'viewer', NULL::uuid),
  ('owner-view', 'viewer', NULL::uuid),
  ('member-x',   'viewer', _sw_id('company:x'))
) AS v(who, role, company_id)
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO app_private.platform_staff (user_id, role, note)
VALUES (_sw_id('user:owner'),      'owner',     'sw'),
       (_sw_id('user:readonly'),   'read_only', 'sw'),
       (_sw_id('user:owner-view'), 'owner',     'sw')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO auth.sessions (id, user_id)
SELECT _sw_id('session:' || v.who), _sw_id('user:' || v.who)
FROM (VALUES ('admin-x'), ('owner'), ('readonly'), ('owner-view')) AS v(who)
ON CONFLICT (id) DO NOTHING;

-- One settings row per company, as every company has; section 6b writes them.
INSERT INTO company_settings (company_id, company_name, iban) VALUES
  (_sw_id('company:x'), 'SW X', 'DE00000000000000000001'),
  (_sw_id('company:y'), 'SW Y', 'DE00000000000000000002')
ON CONFLICT (company_id) DO NOTHING;

INSERT INTO drivers (id, company_id, name) VALUES
  (_sw_id('driver:x1'), _sw_id('company:x'), 'SW Driver X1'),
  (_sw_id('driver:x2'), _sw_id('company:x'), 'SW Driver X2'),
  (_sw_id('driver:x3'), _sw_id('company:x'), 'SW Driver X3'),
  (_sw_id('driver:y1'), _sw_id('company:y'), 'SW Driver Y1')
ON CONFLICT (id) DO NOTHING;

INSERT INTO receipts (id, company_id, receipt_number, date, description, driver_name) VALUES
  (_sw_id('receipt:x'), _sw_id('company:x'), 'BEL-SW-X', '2026-03-02', 'sw', 'SW Driver X1')
ON CONFLICT (id) DO NOTHING;

INSERT INTO salaries (id, company_id, driver_id, period_start, period_end, created_by) VALUES
  (_sw_id('salary:x1'), _sw_id('company:x'), _sw_id('driver:x1'), '2026-01-01', '2026-01-31', _sw_id('user:admin-x'))
ON CONFLICT (id) DO NOTHING;

INSERT INTO fahrtenbuch_imports (id, company_id, month, year, file_name, imported_by) VALUES
  (_sw_id('import:x'), _sw_id('company:x'), 3, 2026, 'sw.xlsx', _sw_id('user:admin-x'))
ON CONFLICT (id) DO NOTHING;

-- Two open trips and one canceled one, which the planning RPCs must skip.
INSERT INTO fahrtenbuch_trips (id, company_id, import_id, trip_date, start_time, end_time,
                               original_driver_name, assigned_driver_name, is_canceled, plausibility_status)
VALUES
  (_sw_id('trip:1'), _sw_id('company:x'), _sw_id('import:x'), '2026-03-02', '08:00', '09:00', 'SW', 'SW', false, 'pending'),
  (_sw_id('trip:2'), _sw_id('company:x'), _sw_id('import:x'), '2026-03-02', '10:00', '11:00', 'SW', 'SW', false, 'pending'),
  (_sw_id('trip:3'), _sw_id('company:x'), _sw_id('import:x'), '2026-03-02', '12:00', '13:00', 'SW', 'SW', true,  'canceled')
ON CONFLICT (id) DO NOTHING;

-- ─── 1. shape ───────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_missing text;
  v_extra   text;
  v_bad     text;
  v_n       bigint;
  v_role    text;
BEGIN
  SELECT string_agg(c.relname::text, ', ' ORDER BY c.relname::text) INTO v_missing
    FROM pg_trigger g
    JOIN pg_class c     ON c.oid = g.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND g.tgname = 'refuse_read_only_context_write'
     AND NOT g.tgisinternal
     AND NOT EXISTS (SELECT 1 FROM pg_trigger a
                      WHERE a.tgrelid = g.tgrelid
                        AND a.tgname = 'record_support_write'
                        AND NOT a.tgisinternal);
  PERFORM _sw_ok('shape: every table the view-context refusal guards also records support writes'
                 || coalesce(' — missing on ' || v_missing, ''),
    v_missing IS NULL);

  SELECT string_agg(c.relname::text, ', ' ORDER BY c.relname::text) INTO v_extra
    FROM pg_trigger a
    JOIN pg_class c ON c.oid = a.tgrelid
   WHERE a.tgname = 'record_support_write'
     AND NOT a.tgisinternal
     AND NOT EXISTS (SELECT 1 FROM pg_trigger g
                      WHERE g.tgrelid = a.tgrelid
                        AND g.tgname = 'refuse_read_only_context_write'
                        AND NOT g.tgisinternal);
  PERFORM _sw_ok('shape: …and no other table does, because nothing else arms it'
                 || coalesce(' — extra on ' || v_extra, ''),
    v_extra IS NULL);

  SELECT count(*) INTO v_n FROM pg_trigger a WHERE a.tgname = 'record_support_write' AND NOT a.tgisinternal;
  PERFORM _sw_ok(format('shape: at least the 39 tables of 3.4a (%s)', v_n), v_n >= 39);

  -- tgtype 29: ROW 1 + INSERT 4 + DELETE 8 + UPDATE 16, not BEFORE, not
  -- INSTEAD, not TRUNCATE.
  SELECT string_agg(c.relname::text, ', ' ORDER BY c.relname::text) INTO v_bad
    FROM pg_trigger a
    JOIN pg_class c ON c.oid = a.tgrelid
   WHERE a.tgname = 'record_support_write'
     AND NOT a.tgisinternal
     AND NOT (a.tgtype = 29
              AND a.tgenabled = 'O'
              AND a.tgqual IS NOT NULL
              AND pg_get_triggerdef(a.oid) ~ 'app_private\.support_write_context');
  PERFORM _sw_ok('shape: each one is an enabled AFTER ROW trigger on insert, update and delete, gated on the flag'
                 || coalesce(' — not on ' || v_bad, ''),
    v_bad IS NULL);

  -- The refusal trigger stays what 3.4a made it: per statement.
  PERFORM _sw_ok('shape: the refusal trigger that arms the audit is still statement-level everywhere',
    NOT EXISTS (SELECT 1 FROM pg_trigger g
                 WHERE g.tgname = 'refuse_read_only_context_write'
                   AND NOT g.tgisinternal
                   AND g.tgtype <> 30));

  SELECT string_agg(c.relname::text, ', ' ORDER BY c.relname::text) INTO v_bad
    FROM pg_trigger a
    JOIN pg_class c ON c.oid = a.tgrelid
   WHERE a.tgname = 'record_support_write'
     AND NOT a.tgisinternal
     AND NOT EXISTS (SELECT 1 FROM pg_attribute t
                      WHERE t.attrelid = c.oid AND t.attname = 'id'
                        AND t.attnum > 0 AND NOT t.attisdropped);
  PERFORM _sw_ok('shape: every audited table has the id column its rows are named by'
                 || coalesce(' — not ' || v_bad, ''),
    v_bad IS NULL);

  -- company_settings and user_profiles are recorded since 20260921110000
  -- (3.13a), but armed by a trigger of their own and not by the refusal
  -- trigger, which would refuse a platform account's own profile row and the
  -- audited RPCs that write those tables. So they carry neither of the two
  -- names paired above; section 6b shows what they do carry.
  PERFORM _sw_ok('shape: company_settings and user_profiles carry neither the refusal trigger nor the paired audit trigger',
    NOT EXISTS (SELECT 1 FROM pg_trigger a
                 WHERE a.tgrelid IN (to_regclass('public.company_settings'), to_regclass('public.user_profiles'))
                   AND a.tgname IN ('record_support_write', 'refuse_read_only_context_write')
                   AND NOT a.tgisinternal));
  -- …but each carries the statement trigger that binds a support session's
  -- company and the three row triggers gated on it: 30 is BEFORE + INSERT +
  -- DELETE + UPDATE per statement, 5, 17 and 9 are AFTER ROW on INSERT,
  -- UPDATE and DELETE.
  PERFORM _sw_ok('shape: …and each carries the shell arming trigger and three gated row triggers calling the audit function',
    (SELECT count(*) FROM pg_trigger g
      WHERE g.tgrelid IN (to_regclass('public.company_settings'), to_regclass('public.user_profiles'))
        AND NOT g.tgisinternal
        AND g.tgenabled = 'O'
        AND ((g.tgname = 'arm_support_shell_write' AND g.tgtype = 30
              AND g.tgfoid = 'app_private.arm_support_shell_write()'::regprocedure)
          OR (g.tgname IN ('record_support_shell_write_insert', 'record_support_shell_write_update',
                           'record_support_shell_write_delete')
              AND g.tgtype IN (5, 17, 9)
              AND g.tgfoid = 'app_private.record_support_write()'::regprocedure
              AND g.tgqual IS NOT NULL
              AND pg_get_triggerdef(g.oid) ~ 'app_private\.support_shell_company'))) = 8);
  PERFORM _sw_ok('shape: …and no other trigger anywhere calls the audit function',
    NOT EXISTS (SELECT 1 FROM pg_trigger g
                 WHERE g.tgfoid = 'app_private.record_support_write()'::regprocedure
                   AND NOT g.tgisinternal
                   AND g.tgname NOT IN ('record_support_write', 'record_support_shell_write_insert',
                                        'record_support_shell_write_update', 'record_support_shell_write_delete')));

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    PERFORM _sw_ok(format('privileges: %s can execute none of the audit functions', v_role),
      NOT has_function_privilege(v_role, 'app_private.record_support_write()', 'EXECUTE')
      AND NOT has_function_privilege(v_role, 'app_private.refuse_read_only_context_write()', 'EXECUTE')
      AND NOT has_function_privilege(v_role, 'app_private.arm_support_shell_write()', 'EXECUTE')
      AND NOT has_function_privilege(v_role, 'app_private.support_write_redaction_pattern(text)', 'EXECUTE')
      AND NOT has_function_privilege(v_role, 'app_private.support_write_values(jsonb)', 'EXECUTE')
      AND NOT has_function_privilege(v_role, 'app_private.guard_company_hard_delete()', 'EXECUTE'));
  END LOOP;

  -- tgtype 11: ROW 1 + BEFORE 2 + DELETE 8.
  PERFORM _sw_ok('shape: companies decides a hard delete before its cascades, with an enabled BEFORE DELETE row trigger',
    EXISTS (SELECT 1 FROM pg_trigger g
             WHERE g.tgrelid = 'public.companies'::regclass
               AND g.tgname = 'guard_company_hard_delete'
               AND NOT g.tgisinternal
               AND g.tgtype = 11
               AND g.tgenabled = 'O'));
END $$;

-- ─── 2. an ordinary member writes, and nothing is recorded ──────────────────

DO $$
DECLARE
  co_x   constant uuid := _sw_id('company:x');
  u_adm  constant uuid := _sw_id('user:admin-x');
  s_adm  constant uuid := _sw_id('session:admin-x');
  v_mark bigint;
BEGIN
  v_mark := _sw_mark();

  -- A flag found set — as if armed by someone earlier in the transaction —
  -- must not reach this member's rows.
  PERFORM set_config('app_private.support_write_context', gen_random_uuid()::text || ':' || gen_random_uuid()::text, true);

  PERFORM _sw_as(u_adm, s_adm);
  INSERT INTO drivers (id, company_id, name) VALUES (_sw_id('driver:member'), co_x, 'SW member');
  UPDATE drivers SET name = 'SW member renamed' WHERE id = _sw_id('driver:member');
  DELETE FROM drivers WHERE id = _sw_id('driver:member');
  PERFORM _sw_reset();

  PERFORM _sw_ok('member: an administrator''s insert, update and delete write no audit row at all',
    (SELECT count(*) FROM app_private.platform_audit_log l WHERE l.id > v_mark) = 0);
  PERFORM _sw_ok('member: …and its first statement cleared the flag it found',
    current_setting('app_private.support_write_context', true) = '');
END $$;

-- ─── 3. a support session writes, and each row is recorded ──────────────────

DO $$
DECLARE
  co_x  constant uuid  := _sw_id('company:x');
  u_o   constant uuid  := _sw_id('user:owner');
  s_o   constant uuid  := _sw_id('session:owner');
  c_red constant jsonb := '{"redacted": true}';
  v_open jsonb;
  v_ctx  uuid;
  v_mark bigint;
  r      app_private.platform_audit_log%ROWTYPE;
BEGIN
  PERFORM _sw_as(u_o, s_o);
  v_open := public.platform_context_open(co_x, 'support', 'Ticket 3.4c');
  PERFORM _sw_reset();
  PERFORM _sw_ok('support: the owner opens a support session on company X with a reason',
    (v_open ->> 'success') = 'true');
  v_ctx := (v_open -> 'context' ->> 'id')::uuid;

  -- INSERT
  v_mark := _sw_mark();
  PERFORM _sw_as(u_o, s_o);
  INSERT INTO drivers (id, company_id, name) VALUES (_sw_id('driver:new'), co_x, 'SW new');
  PERFORM _sw_reset();

  PERFORM _sw_ok('insert: exactly one audit row',
    (SELECT count(*) FROM app_private.platform_audit_log l WHERE l.id > v_mark) = 1);
  SELECT * INTO r FROM app_private.platform_audit_log l WHERE l.id > v_mark;
  PERFORM _sw_ok('insert: category support, and the action names the table and the operation',
    r.category = 'support' AND r.action = 'support_write.drivers.insert' AND r.outcome = 'ok');
  PERFORM _sw_ok('insert: the company, the table and the row',
    r.company_id = co_x AND r.target_type = 'drivers' AND r.target_id = _sw_id('driver:new')::text);
  PERFORM _sw_ok('insert: the actor, its platform role, and the sign-in session the context is bound to',
    r.actor_user_id = u_o AND r.actor_role = 'owner' AND r.session_id = s_o);
  PERFORM _sw_ok('insert: the open context and its reason',
    (r.after_value ->> 'context_id') = v_ctx::text AND (r.after_value ->> 'reason') = 'Ticket 3.4c');
  PERFORM _sw_ok('insert: nothing before, the new row after',
    r.before_value IS NULL
    AND (r.after_value -> 'values' ->> 'name') = 'SW new'
    AND (r.after_value -> 'values' ->> 'company_id') = co_x::text
    AND (r.after_value -> 'values' ->> 'id') = _sw_id('driver:new')::text);
  PERFORM _sw_ok('insert: the new row''s pay and identifier columns are markers, even where they hold a default or nothing',
    (r.after_value -> 'values' -> 'salary_ratio') = c_red
    AND (r.after_value -> 'values' -> 'personalnummer') = c_red
    AND (r.after_value -> 'values' -> 'gender') = c_red);

  -- A recipient list entry (20261015140000): the address is copied in the
  -- clear, which is the decision the migration header records.
  v_mark := _sw_mark();
  PERFORM _sw_as(u_o, s_o);
  INSERT INTO notification_recipients (company_id, notification_type, email)
  VALUES (co_x, 'manager_summary', 'sw-recipient@example.com');
  PERFORM _sw_reset();
  PERFORM _sw_ok('recipients: a support session''s insert is recorded once, and the address is by value',
    _sw_rows(v_mark) = 1 AND _sw_rows(v_mark, 'support_write.notification_recipients.insert') = 1
    AND (SELECT (l.after_value -> 'values' ->> 'email') = 'sw-recipient@example.com'
                AND l.company_id = co_x
           FROM app_private.platform_audit_log l WHERE l.id > v_mark));

  -- UPDATE of one row
  v_mark := _sw_mark();
  PERFORM _sw_as(u_o, s_o);
  UPDATE drivers SET name = 'SW renamed', salary_ratio = 0.4 WHERE id = _sw_id('driver:x1');
  PERFORM _sw_reset();

  PERFORM _sw_ok('update: exactly one audit row',
    (SELECT count(*) FROM app_private.platform_audit_log l WHERE l.id > v_mark) = 1);
  SELECT * INTO r FROM app_private.platform_audit_log l WHERE l.id > v_mark;
  PERFORM _sw_ok('update: on that driver',
    r.action = 'support_write.drivers.update' AND r.target_id = _sw_id('driver:x1')::text AND r.company_id = co_x);
  PERFORM _sw_ok('update: only the two columns that changed, on both sides',
    _sw_keys(r.before_value -> 'values') = ARRAY['name', 'salary_ratio']
    AND _sw_keys(r.after_value -> 'values') = ARRAY['name', 'salary_ratio']);
  PERFORM _sw_ok('update: the name in clear, before and after',
    (r.before_value -> 'values' ->> 'name') = 'SW Driver X1'
    AND (r.after_value -> 'values' ->> 'name') = 'SW renamed');
  PERFORM _sw_ok('update: the salary ratio as a marker on both sides — that it changed, not to what',
    (r.before_value -> 'values' -> 'salary_ratio') = c_red
    AND (r.after_value -> 'values' -> 'salary_ratio') = c_red);

  -- UPDATE of two rows in one statement
  v_mark := _sw_mark();
  PERFORM _sw_as(u_o, s_o);
  UPDATE drivers SET status = 'inactive' WHERE id IN (_sw_id('driver:x2'), _sw_id('driver:x3'));
  PERFORM _sw_reset();

  PERFORM _sw_ok('multi-row: one audit row per row the statement wrote',
    _sw_rows(v_mark) = 2 AND _sw_rows(v_mark, 'support_write.drivers.update') = 2);
  PERFORM _sw_ok('multi-row: one for each driver',
    (SELECT array_agg(l.target_id ORDER BY l.target_id) FROM app_private.platform_audit_log l WHERE l.id > v_mark)
      = (SELECT array_agg(t.id ORDER BY t.id) FROM unnest(ARRAY[_sw_id('driver:x2')::text, _sw_id('driver:x3')::text]) AS t(id)));

  -- DELETE
  v_mark := _sw_mark();
  PERFORM _sw_as(u_o, s_o);
  DELETE FROM receipts WHERE id = _sw_id('receipt:x');
  PERFORM _sw_reset();

  PERFORM _sw_ok('delete: exactly one audit row',
    (SELECT count(*) FROM app_private.platform_audit_log l WHERE l.id > v_mark) = 1);
  SELECT * INTO r FROM app_private.platform_audit_log l WHERE l.id > v_mark;
  PERFORM _sw_ok('delete: the destroyed row before, nothing after, and still the context',
    r.action = 'support_write.receipts.delete'
    AND r.target_id = _sw_id('receipt:x')::text
    AND (r.before_value -> 'values' ->> 'receipt_number') = 'BEL-SW-X'
    AND (r.after_value -> 'values') = 'null'::jsonb
    AND (r.after_value ->> 'context_id') = v_ctx::text);

  -- A write that changes nothing is still a write.
  v_mark := _sw_mark();
  PERFORM _sw_as(u_o, s_o);
  UPDATE drivers SET name = name WHERE id = _sw_id('driver:x1');
  PERFORM _sw_reset();

  SELECT * INTO r FROM app_private.platform_audit_log l WHERE l.id > v_mark;
  PERFORM _sw_ok('no-op: an update that changes nothing is recorded once, with two empty objects',
    _sw_rows(v_mark) = 1
    AND (r.before_value -> 'values') = '{}'::jsonb
    AND (r.after_value -> 'values') = '{}'::jsonb);
END $$;

-- ─── 4. what the log keeps of a value ───────────────────────────────────────

DO $$
DECLARE
  u_o   constant uuid  := _sw_id('user:owner');
  s_o   constant uuid  := _sw_id('session:owner');
  c_red constant jsonb := '{"redacted": true}';
  v_mark bigint;
  r      app_private.platform_audit_log%ROWTYPE;
BEGIN
  -- The explicit list: amount_due and notes say nothing about pay by name.
  v_mark := _sw_mark();
  PERFORM _sw_as(u_o, s_o);
  UPDATE salaries SET amount_due = 123.45, notes = 'Vorschuss', status = 'paid' WHERE id = _sw_id('salary:x1');
  PERFORM _sw_reset();

  SELECT * INTO r FROM app_private.platform_audit_log l WHERE l.id > v_mark;
  PERFORM _sw_ok('salary: one row, on the salary',
    _sw_rows(v_mark) = 1 AND r.action = 'support_write.salaries.update' AND r.target_id = _sw_id('salary:x1')::text);
  PERFORM _sw_ok('salary: the amount due and the note are markers on both sides',
    (r.before_value -> 'values' -> 'amount_due') = c_red AND (r.after_value -> 'values' -> 'amount_due') = c_red
    AND (r.before_value -> 'values' -> 'notes') = c_red AND (r.after_value -> 'values' -> 'notes') = c_red);
  PERFORM _sw_ok('salary: the status is in clear',
    (r.before_value -> 'values' ->> 'status') = 'unpaid' AND (r.after_value -> 'values' ->> 'status') = 'paid');
  PERFORM _sw_ok('salary: no figure of the salary appears anywhere in the row',
    position('123.45' IN r.after_value::text) = 0 AND position('Vorschuss' IN r.after_value::text) = 0);

  -- A long value is kept as its size; an array of plain values is copied.
  v_mark := _sw_mark();
  PERFORM _sw_as(u_o, s_o);
  UPDATE drivers
     SET work_window_start    = repeat('x', 2000),
         planned_working_days = ARRAY['mon', 'sat']::text[]
   WHERE id = _sw_id('driver:x1');
  PERFORM _sw_reset();

  SELECT * INTO r FROM app_private.platform_audit_log l WHERE l.id > v_mark;
  PERFORM _sw_ok('size: a value over 1 KiB is recorded as its size, not copied',
    (r.after_value -> 'values' -> 'work_window_start') = '{"omitted": true, "bytes": 2002}'::jsonb);
  PERFORM _sw_ok('size: an array of plain values is copied',
    (r.after_value -> 'values' -> 'planned_working_days') = '["mon", "sat"]'::jsonb);

  -- The free text of a driver note may say why someone was absent.
  v_mark := _sw_mark();
  PERFORM _sw_as(u_o, s_o);
  INSERT INTO driver_notes (id, created_by, driver_id, note_text, company_id)
  VALUES (_sw_id('note:x1'), u_o, _sw_id('driver:x1'), 'krank', _sw_id('company:x'));
  PERFORM _sw_reset();

  SELECT * INTO r FROM app_private.platform_audit_log l WHERE l.id > v_mark;
  PERFORM _sw_ok('note: the note''s text is a marker, its type is in clear',
    r.action = 'support_write.driver_notes.insert'
    AND (r.after_value -> 'values' -> 'note_text') = c_red
    AND (r.after_value -> 'values' ->> 'note_type') = 'general'
    AND position('krank' IN r.after_value::text) = 0);
END $$;

-- ─── 5. a view context still writes nothing ─────────────────────────────────

DO $$
DECLARE
  co_x  constant uuid := _sw_id('company:x');
  u_ro  constant uuid := _sw_id('user:readonly');
  s_ro  constant uuid := _sw_id('session:readonly');
  v_open jsonb;
  v_mark bigint;
BEGIN
  PERFORM _sw_as(u_ro, s_ro);
  v_open := public.platform_context_open(co_x, 'view');
  PERFORM _sw_reset();
  PERFORM _sw_ok('view: the read_only account opens a view context', (v_open ->> 'success') = 'true');

  v_mark := _sw_mark();
  PERFORM _sw_ok('view: its write is refused by the statement trigger, with 3.4a''s sentence',
    _sw_try(u_ro, s_ro, format('UPDATE drivers SET name = %L WHERE id = %L', 'SW view', _sw_id('driver:x1')))
      LIKE 'ERR P0001 Nur-Lese-Ansicht:%Support-Sitzung%');
  PERFORM _sw_ok('view: …on an ungated table too, and nothing is recorded for it',
    _sw_try(u_ro, s_ro, format('DELETE FROM fahrtenbuch_trips WHERE id = %L', _sw_id('trip:1'))) LIKE 'ERR P0001%'
    AND _sw_rows(v_mark) = 0);
END $$;

-- ─── 6. a support session's write outside its company ───────────────────────

DO $$
DECLARE
  co_y  constant uuid := _sw_id('company:y');
  u_o   constant uuid := _sw_id('user:owner');
  s_o   constant uuid := _sw_id('session:owner');
  v_mark bigint;
  v_rows bigint;
BEGIN
  v_mark := _sw_mark();
  PERFORM _sw_as(u_o, s_o);
  UPDATE drivers SET name = 'SW other' WHERE id = _sw_id('driver:y1');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM _sw_reset();

  PERFORM _sw_ok('elsewhere: another company''s row is not visible, is not written and is not recorded',
    v_rows = 0 AND _sw_rows(v_mark) = 0);
  PERFORM _sw_ok('elsewhere: an insert into another company is refused by RLS',
    _sw_try(u_o, s_o, format('INSERT INTO drivers (company_id, name) VALUES (%L, %L)', co_y, 'SW other'))
      LIKE 'ERR 42501%row-level security%');
END $$;

-- ─── 6b. the account shell: only inside the session, and recorded (3.13a) ───
--
-- 20260921110000: company_settings and user_profiles are written by a platform
-- account only inside a support session on the row's company, and those writes
-- are recorded by the same audit function, armed by a statement trigger of
-- their own that binds the session's company. Before it, `super` edited any
-- company's settings with no context, and a view context changed the profiles
-- of the company it read — both with no audit row.
--
-- Every write whose audit row is the subject is made outside _sw_try, which
-- rolls its own writes back, audit rows included; and each count is read in a
-- statement of its own, after the write it counts.

CREATE FUNCTION _sw_definer_settings_write(p_company uuid) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
DECLARE v_rows bigint;
BEGIN
  -- Stands for platform_subscription_assign: an audited platform RPC that
  -- writes company_settings for the company in its argument, past RLS.
  UPDATE company_settings SET drivers_per_car_limit = drivers_per_car_limit WHERE company_id = p_company;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows;
END $$;

DO $$
DECLARE
  co_x    constant uuid  := _sw_id('company:x');
  co_y    constant uuid  := _sw_id('company:y');
  u_o     constant uuid  := _sw_id('user:owner');
  s_o     constant uuid  := _sw_id('session:owner');
  u_ov    constant uuid  := _sw_id('user:owner-view');
  s_ov    constant uuid  := _sw_id('session:owner-view');
  u_adm   constant uuid  := _sw_id('user:admin-x');
  s_adm   constant uuid  := _sw_id('session:admin-x');
  u_mem   constant uuid  := _sw_id('user:member-x');
  -- seed.sql's platform owner: no sign-in session, so no context at all
  u_super constant uuid  := '50000000-0000-4000-8000-000000000001';
  c_red   constant jsonb := '{"redacted": true}';
  v_ctx   constant uuid  := _sw_owner_context();
  v_open  jsonb;
  v_mark  bigint;
  v_rows  bigint;
  v_n     bigint;
  r       app_private.platform_audit_log%ROWTYPE;
BEGIN
  /*
    No context: an owner holding every capability writes neither table — and
    since 20260923100000 (plan 3.13b) does not read company_settings either.

    The read half of this line used to answer 1: company_settings_select carried
    `OR platform_can('companies.read')`, which all four staff roles hold, so
    every platform account read every customer's legal name, managing director,
    VAT and tax number, bank name, IBAN, BIC and account holder with no context
    and no audit row. 3.13a had already moved the writes onto the support
    session, which is what the rest of this line measures; 3.13b took the
    capability out of the read, so both halves are now zero.
  */
  PERFORM _sw_ok('shell, no context: an owner neither edits nor reads a company''s settings (3.13b)',
    _sw_try(u_super, NULL, format('UPDATE company_settings SET company_name = %L WHERE company_id = %L', 'SW no', co_x)) = 'rows 0'
    AND _sw_try(u_super, NULL, format('SELECT count(*)::text FROM company_settings WHERE company_id = %L', co_x)) = '0');
  PERFORM _sw_ok('shell, no context: …deletes none and inserts none',
    _sw_try(u_super, NULL, format('DELETE FROM company_settings WHERE company_id = %L', co_y)) = 'rows 0'
    AND _sw_try(u_super, NULL, format('INSERT INTO company_settings (company_id, company_name) VALUES (%L, %L)', co_y, 'SW no'))
          LIKE 'ERR 42501%row-level security%');
  PERFORM _sw_ok('shell, no context: …and reaches no company''s profile',
    _sw_try(u_super, NULL, format('UPDATE user_profiles SET full_name = %L WHERE user_id = %L', 'SW no', u_mem)) = 'rows 0');

  -- A view context: the same owner rights, and still nothing.
  PERFORM _sw_as(u_ov, s_ov);
  v_open := public.platform_context_open(co_x, 'view');
  PERFORM _sw_reset();
  PERFORM _sw_ok('shell, view: a second owner opens a view context on company X', (v_open ->> 'success') = 'true');

  PERFORM _sw_ok('shell, view: it reads company X''s settings and member',
    _sw_try(u_ov, s_ov, format('SELECT count(*)::text FROM company_settings WHERE company_id = %L', co_x)) = '1'
    AND _sw_try(u_ov, s_ov, format('SELECT count(*)::text FROM user_profiles WHERE user_id = %L', u_mem)) = '1');
  PERFORM _sw_ok('shell, view: …and writes neither — no settings update, no insert, no profile update or delete',
    _sw_try(u_ov, s_ov, format('UPDATE company_settings SET company_name = %L WHERE company_id = %L', 'SW view', co_x)) = 'rows 0'
    AND _sw_try(u_ov, s_ov, format('INSERT INTO company_settings (company_id, company_name) VALUES (%L, %L)', co_x, 'SW view'))
          LIKE 'ERR 42501%row-level security%'
    AND _sw_try(u_ov, s_ov, format('UPDATE user_profiles SET full_name = %L WHERE user_id = %L', 'SW view', u_mem)) = 'rows 0'
    AND _sw_try(u_ov, s_ov, format('DELETE FROM user_profiles WHERE user_id = %L', u_mem)) = 'rows 0');

  v_mark := _sw_mark();
  PERFORM _sw_as(u_ov, s_ov);
  UPDATE user_profiles SET full_name = 'SW owner-view renamed' WHERE user_id = u_ov;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM _sw_reset();
  PERFORM _sw_ok('shell, view: its own profile row is still its own to write', v_rows = 1);
  PERFORM _sw_ok('shell, view: …and that write is not recorded as a company''s', _sw_rows(v_mark) = 0);

  -- The support session (section 3's, on company X): the company's settings.
  v_mark := _sw_mark();
  PERFORM _sw_as(u_o, s_o);
  UPDATE company_settings SET company_name = 'SW X renamed', iban = 'DE00000000000000000099', notification_email = 'sw-notify@example.com' WHERE company_id = co_x;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM _sw_reset();
  PERFORM _sw_ok('shell, support: the session updates the settings of the company it opened', v_rows = 1);
  PERFORM _sw_ok('shell, support: …and the update is recorded, once',
    _sw_rows(v_mark) = 1 AND _sw_rows(v_mark, 'support_write.company_settings.update') = 1);
  SELECT * INTO r FROM app_private.platform_audit_log l WHERE l.id > v_mark;
  PERFORM _sw_ok('shell, support: the row names the company, the table, the row, the actor, its session and the context',
    r.category = 'support'
    AND r.company_id = co_x
    AND r.target_type = 'company_settings'
    AND r.target_id = (SELECT s.id::text FROM company_settings s WHERE s.company_id = co_x)
    AND r.actor_user_id = u_o AND r.actor_role = 'owner' AND r.session_id = s_o
    AND (r.after_value ->> 'context_id') = v_ctx::text
    AND (r.after_value ->> 'reason') = 'Ticket 3.4c');
  PERFORM _sw_ok('shell, support: the changed columns are there, the IBAN as a marker on both sides, an untouched column is not',
    (r.before_value -> 'values' ->> 'company_name') = 'SW X'
    AND (r.after_value -> 'values' ->> 'company_name') = 'SW X renamed'
    AND (r.before_value -> 'values' -> 'iban') = c_red
    AND (r.after_value -> 'values' -> 'iban') = c_red
    AND position('DE000000000000000000' IN r.after_value::text) = 0
    AND NOT ((r.after_value -> 'values') ? 'city'));
  PERFORM _sw_ok('shell, support: the notification address is recorded like the other contact columns (20261015100000), by value',
    (r.after_value -> 'values' ->> 'notification_email') = 'sw-notify@example.com');

  -- Delete and insert again: the session holds companies.hard_delete, and the
  -- row comes back through the insert policy's support branch.
  v_mark := _sw_mark();
  PERFORM _sw_as(u_o, s_o);
  DELETE FROM company_settings WHERE company_id = co_x;
  INSERT INTO company_settings (company_id, company_name) VALUES (co_x, 'SW X again');
  PERFORM _sw_reset();
  PERFORM _sw_ok('shell, support: a delete and an insert of the company''s settings are one row each',
    _sw_rows(v_mark) = 2
    AND _sw_rows(v_mark, 'support_write.company_settings.delete') = 1
    AND _sw_rows(v_mark, 'support_write.company_settings.insert') = 1);

  -- Another company's settings: readable, not writable, not recorded.
  v_mark := _sw_mark();
  PERFORM _sw_as(u_o, s_o);
  UPDATE company_settings SET company_name = 'SW Y renamed' WHERE company_id = co_y;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM _sw_reset();
  PERFORM _sw_ok('shell, support: company Y''s settings are not written from a session on company X',
    v_rows = 0);
  PERFORM _sw_ok('shell, support: …and nothing is recorded for them', _sw_rows(v_mark) = 0);

  -- An audited platform RPC writing the settings of the company in its
  -- argument, with a session open on another company: written, not refused,
  -- and not recorded as the session's — the RPC records itself. The same
  -- write on the session's own company is the session's, and is recorded.
  v_mark := _sw_mark();
  PERFORM _sw_as(u_o, s_o);
  v_rows := _sw_definer_settings_write(co_y);
  PERFORM _sw_reset();
  PERFORM _sw_ok('shell, rpc: a definer write to another company''s settings goes through during the session',
    v_rows = 1);
  PERFORM _sw_ok('shell, rpc: …and is neither refused nor recorded against the session', _sw_rows(v_mark) = 0);

  v_mark := _sw_mark();
  PERFORM _sw_as(u_o, s_o);
  v_rows := _sw_definer_settings_write(co_x);
  PERFORM _sw_reset();
  PERFORM _sw_ok('shell, rpc: the same write on the session''s own company is recorded',
    v_rows = 1 AND _sw_rows(v_mark, 'support_write.company_settings.update') = 1);

  -- The company's accounts.
  v_mark := _sw_mark();
  PERFORM _sw_as(u_o, s_o);
  UPDATE user_profiles SET full_name = 'SW member renamed' WHERE user_id = u_mem;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM _sw_reset();
  PERFORM _sw_ok('shell, support: the session updates a member of the company it opened', v_rows = 1);
  SELECT * INTO r FROM app_private.platform_audit_log l
   WHERE l.id > v_mark AND l.action = 'support_write.user_profiles.update';
  PERFORM _sw_ok('shell, support: …recorded against the company, the profile and the context, with the name before and after',
    _sw_rows(v_mark) = 1
    AND r.company_id = co_x
    AND r.target_type = 'user_profiles'
    AND r.target_id = (SELECT p.id::text FROM user_profiles p WHERE p.user_id = u_mem)
    AND (r.after_value ->> 'context_id') = v_ctx::text
    AND (r.before_value -> 'values' ->> 'full_name') = 'SW member-x'
    AND (r.after_value -> 'values' ->> 'full_name') = 'SW member renamed');

  v_mark := _sw_mark();
  PERFORM _sw_as(u_o, s_o);
  UPDATE user_profiles SET full_name = 'SW owner renamed' WHERE user_id = u_o;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM _sw_reset();
  PERFORM _sw_ok('shell, support: the session''s own profile row is written', v_rows = 1);
  PERFORM _sw_ok('shell, support: …and not recorded — it belongs to no company', _sw_rows(v_mark) = 0);

  v_mark := _sw_mark();
  PERFORM _sw_as(u_o, s_o);
  DELETE FROM user_profiles WHERE user_id = u_mem;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM _sw_reset();
  PERFORM _sw_ok('shell, support: deleting a member''s profile is recorded, once',
    v_rows = 1 AND _sw_rows(v_mark, 'support_write.user_profiles.delete') = 1);

  -- A company member: its own administrator writes the settings as before, and
  -- nothing is recorded — also when the binding was left set by the session.
  PERFORM _sw_as(u_o, s_o);
  UPDATE company_settings SET company_name = company_name WHERE company_id = co_x;
  PERFORM _sw_reset();
  PERFORM _sw_ok('shell, member: the session''s statement left its company bound',
    current_setting('app_private.support_shell_company', true) = co_x::text);

  v_mark := _sw_mark();
  PERFORM _sw_as(u_adm, s_adm);
  UPDATE company_settings SET company_name = 'SW X by its admin' WHERE company_id = co_x;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM _sw_reset();
  PERFORM _sw_ok('shell, member: the company''s administrator still writes its settings', v_rows = 1);
  v_n := (SELECT count(*) FROM app_private.platform_audit_log l WHERE l.id > v_mark);
  PERFORM _sw_ok('shell, member: …with no audit row at all', v_n = 0);
  PERFORM _sw_ok('shell, member: …because its statement cleared the binding first',
    current_setting('app_private.support_shell_company', true) = '');
END $$;

DROP FUNCTION _sw_definer_settings_write(uuid);

-- ─── 7. the planning RPCs ───────────────────────────────────────────────────
--
-- apply writes each trip in its own UPDATE, so the statement trigger already
-- runs once per trip and the audit adds one row per trip. The decided counts:
--   apply    1 run insert + T trips + E exceptions + 1 run update = T + E + 2
--   replace  1 old-run update + D detached + 1 run insert + T trips
--            + E exceptions + 1 run update                        = D + T + E + 3
-- Here T = 2 (the third trip is canceled and is not written), E = 1 on apply and
-- 0 on replace, D = 2.

DO $$
DECLARE
  u_o   constant uuid := _sw_id('user:owner');
  s_o   constant uuid := _sw_id('session:owner');
  c_immutable constant text[] := ARRAY['trip_date', 'start_time', 'end_time', 'duration_minutes',
                                       'car_id', 'car_identifier', 'route_start', 'route_end',
                                       'description', 'price_amount', 'cash_amount', 'online_amount',
                                       'tip_amount', 'action_amount', 'raw_data_json',
                                       'original_driver_id', 'original_driver_name', 'import_id',
                                       'company_id', 'source_status', 'is_canceled'];
  v_apply   jsonb;
  v_replace jsonb;
  v_mark    bigint;
  r         app_private.platform_audit_log%ROWTYPE;
BEGIN
  v_mark := _sw_mark();
  PERFORM _sw_as(u_o, s_o);
  v_apply := public.apply_monthly_planning_run(jsonb_build_object(
    'import_id', _sw_id('import:x'), 'month', 3, 'year', 2026,
    'change_rows', jsonb_build_array(
      jsonb_build_object('trip_id', _sw_id('trip:1'), 'driver_id', _sw_id('driver:x1'),
                         'driver_name', 'SW Driver X1', 'assignment_source', 'auto', 'block_id', 'B1'),
      jsonb_build_object('trip_id', _sw_id('trip:2'), 'driver_id', _sw_id('driver:x1'),
                         'driver_name', 'SW Driver X1', 'assignment_source', 'auto', 'block_id', 'B1'),
      jsonb_build_object('trip_id', _sw_id('trip:3'), 'driver_id', _sw_id('driver:x1'),
                         'driver_name', 'SW Driver X1', 'assignment_source', 'auto', 'block_id', 'B1')),
    'manual_exceptions', jsonb_build_array(
      jsonb_build_object('block_id', 'B1', 'driver_id', _sw_id('driver:x1'), 'driver_name', 'SW Driver X1',
                         'service_date', '2026-03-02', 'dienstzeit', true, 'reason', 'SW'))));
  PERFORM _sw_reset();

  PERFORM _sw_ok('apply: the RPC succeeds inside the support session and writes the two open trips',
    (v_apply ->> 'success') = 'true' AND (v_apply ->> 'updated_trips')::int = 2);
  PERFORM _sw_ok(format('apply: T + E + 2 = 5 audit rows (%s)', _sw_rows(v_mark)),
    _sw_rows(v_mark) = 5);
  PERFORM _sw_ok('apply: the run inserted and updated once each, two trips, one exception',
    _sw_rows(v_mark, 'support_write.company_planning_runs.insert') = 1
    AND _sw_rows(v_mark, 'support_write.company_planning_runs.update') = 1
    AND _sw_rows(v_mark, 'support_write.fahrtenbuch_trips.update') = 2
    AND _sw_rows(v_mark, 'support_write.monthly_planning_manual_exceptions.insert') = 1);
  PERFORM _sw_ok('apply: the canceled trip was not written, so it is not recorded',
    NOT EXISTS (SELECT 1 FROM app_private.platform_audit_log l
                 WHERE l.id > v_mark AND l.target_id = _sw_id('trip:3')::text));

  SELECT * INTO r FROM app_private.platform_audit_log l
   WHERE l.id > v_mark AND l.action = 'support_write.fahrtenbuch_trips.update'
     AND l.target_id = _sw_id('trip:1')::text;
  PERFORM _sw_ok('apply: the trip''s row records the assignment it changed',
    (r.before_value -> 'values' -> 'assigned_driver_id') = 'null'::jsonb
    AND (r.after_value -> 'values' ->> 'assigned_driver_id') = _sw_id('driver:x1')::text
    AND (r.after_value -> 'values' ->> 'assignment_planning_run_id') = (v_apply ->> 'planning_run_id'));
  PERFORM _sw_ok('apply: …and none of the columns protect_fahrtenbuch_immutable_fields holds still',
    NOT ((r.before_value -> 'values') ?| c_immutable)
    AND NOT ((r.after_value -> 'values') ?| c_immutable));

  SELECT * INTO r FROM app_private.platform_audit_log l
   WHERE l.id > v_mark AND l.action = 'support_write.company_planning_runs.insert';
  PERFORM _sw_ok('apply: a JSON document is recorded by its size and never copied',
    (r.after_value -> 'values' -> 'summary_json' ->> 'omitted') = 'true'
    AND (r.after_value -> 'values' -> 'summary_json') ? 'bytes'
    AND NOT ((r.after_value -> 'values' -> 'summary_json') ? 'block_separator_minutes')
    AND (r.after_value -> 'values' ->> 'status') = 'applied');

  -- replace: the old run's trips are detached in one bulk UPDATE, recorded row
  -- by row, then reassigned one by one.
  v_mark := _sw_mark();
  PERFORM _sw_as(u_o, s_o);
  v_replace := public.replace_monthly_planning_run(jsonb_build_object(
    'import_id', _sw_id('import:x'), 'month', 3, 'year', 2026,
    'change_rows', jsonb_build_array(
      jsonb_build_object('trip_id', _sw_id('trip:1'), 'driver_id', _sw_id('driver:x2'),
                         'driver_name', 'SW Driver X2', 'assignment_source', 'auto', 'block_id', 'B2'),
      jsonb_build_object('trip_id', _sw_id('trip:2'), 'driver_id', _sw_id('driver:x2'),
                         'driver_name', 'SW Driver X2', 'assignment_source', 'auto', 'block_id', 'B2'))),
    (v_apply ->> 'planning_run_id')::uuid);
  PERFORM _sw_reset();

  PERFORM _sw_ok('replace: the RPC succeeds, detaching two trips and reassigning two',
    (v_replace ->> 'success') = 'true'
    AND (v_replace ->> 'updated_trips')::int = 2
    AND (v_replace ->> 'detached_trips_from_old_run')::int = 2);
  PERFORM _sw_ok(format('replace: D + T + E + 3 = 7 audit rows (%s)', _sw_rows(v_mark)),
    _sw_rows(v_mark) = 7);
  PERFORM _sw_ok('replace: two run updates, one run insert, four trip updates',
    _sw_rows(v_mark, 'support_write.company_planning_runs.update') = 2
    AND _sw_rows(v_mark, 'support_write.company_planning_runs.insert') = 1
    AND _sw_rows(v_mark, 'support_write.fahrtenbuch_trips.update') = 4);
  PERFORM _sw_ok('replace: the bulk detach left one row per trip, each carrying the one column it changed',
    (SELECT count(*) FROM app_private.platform_audit_log l
      WHERE l.id > v_mark
        AND l.action = 'support_write.fahrtenbuch_trips.update'
        AND (l.after_value -> 'values') = '{"assignment_planning_run_id": null}'::jsonb) = 2);
END $$;

-- ─── 8. the immutability trigger fires first ────────────────────────────────
--
-- fahrtenbuch_trips has no UPDATE policy, so a support session reaches a trip
-- only through the planning RPCs, which never touch an immutable column. To show
-- the order of the two triggers on a direct write, this section adds an UPDATE
-- policy for the length of two statements and drops it again; the whole file
-- rolls back in any case.

CREATE POLICY _sw_tmp_trips_update ON public.fahrtenbuch_trips
  FOR UPDATE TO authenticated
  USING (company_id = (SELECT public.get_active_company_id()))
  WITH CHECK (company_id = (SELECT public.get_active_company_id()));

DO $$
DECLARE
  u_o   constant uuid := _sw_id('user:owner');
  s_o   constant uuid := _sw_id('session:owner');
  v_mark bigint;
  r      app_private.platform_audit_log%ROWTYPE;
BEGIN
  PERFORM _sw_ok('trips: a change to an immutable column is refused by the BEFORE ROW trigger, before the AFTER ROW audit could run',
    _sw_try(u_o, s_o, format('UPDATE fahrtenbuch_trips SET trip_date = %L WHERE id = %L', '2026-03-09', _sw_id('trip:1')))
      LIKE 'ERR P0001 fahrtenbuch_trips: immutable fields%');

  v_mark := _sw_mark();
  PERFORM _sw_as(u_o, s_o);
  UPDATE fahrtenbuch_trips SET assignment_note = 'SW Notiz' WHERE id = _sw_id('trip:1');
  PERFORM _sw_reset();

  SELECT * INTO r FROM app_private.platform_audit_log l WHERE l.id > v_mark;
  PERFORM _sw_ok('trips: a change to a mutable column is recorded once, with that column alone',
    _sw_rows(v_mark) = 1
    AND r.action = 'support_write.fahrtenbuch_trips.update'
    AND _sw_keys(r.after_value -> 'values') = ARRAY['assignment_note']
    AND (r.after_value -> 'values' ->> 'assignment_note') = 'SW Notiz');
END $$;

DROP POLICY _sw_tmp_trips_update ON public.fahrtenbuch_trips;

-- ─── 9. the flag belongs to one account ─────────────────────────────────────

DO $$
DECLARE
  u_o   constant uuid := _sw_id('user:owner');
  s_o   constant uuid := _sw_id('session:owner');
  u_adm constant uuid := _sw_id('user:admin-x');
  s_adm constant uuid := _sw_id('session:admin-x');
  v_mark bigint;
BEGIN
  PERFORM _sw_as(u_o, s_o);
  UPDATE drivers SET name = name WHERE id = _sw_id('driver:x1');
  PERFORM _sw_reset();
  PERFORM _sw_ok('one account: the owner''s write left the audit armed with its own session and its own name',
    current_setting('app_private.support_write_context', true) = _sw_owner_context()::text || ':' || u_o::text);

  v_mark := _sw_mark();
  PERFORM _sw_as(u_adm, s_adm);
  UPDATE drivers SET name = name WHERE id = _sw_id('driver:x1');
  PERFORM _sw_reset();
  PERFORM _sw_ok('one account: a member''s write later in the same transaction is not recorded',
    (SELECT count(*) FROM app_private.platform_audit_log l WHERE l.id > v_mark) = 0);
  PERFORM _sw_ok('one account: …because the member''s statement cleared the owner''s flag',
    current_setting('app_private.support_write_context', true) = '');
END $$;

/*
  A flag set after the statement trigger has run — which no API caller can do,
  since no function a client can reach calls set_config — is the only way past
  the check above. A BEFORE ROW trigger that sets it stands in for such a
  forger. The audit function reads the account the flag names and looks the
  session up again, so a forged flag can neither record a write in the owner's
  name nor let one through unrecorded.
*/
CREATE FUNCTION _sw_forge() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('app_private.support_write_context', current_setting('sw.forge', true), true);
  RETURN NEW;
END $$;

CREATE TRIGGER _sw_forge BEFORE UPDATE ON public.drivers
  FOR EACH ROW EXECUTE FUNCTION _sw_forge();

DO $$
DECLARE
  u_adm constant uuid := _sw_id('user:admin-x');
  s_adm constant uuid := _sw_id('session:admin-x');
  v_sql text := format('UPDATE drivers SET name = name WHERE id = %L', _sw_id('driver:x1'));
BEGIN
  PERFORM set_config('sw.forge', _sw_owner_context()::text || ':' || _sw_id('user:owner')::text, true);
  PERFORM _sw_ok('forgery: a member carrying the owner''s own flag cannot write a row in the owner''s name — the write fails',
    _sw_try(u_adm, s_adm, v_sql) LIKE 'ERR P0001 Support-Schreibzugriff auf drivers kann nicht protokolliert werden und wird abgelehnt.');

  PERFORM set_config('sw.forge', _sw_owner_context()::text || ':' || u_adm::text, true);
  PERFORM _sw_ok('forgery: …nor by naming itself beside the owner''s session, which is not its own',
    _sw_try(u_adm, s_adm, v_sql) LIKE 'ERR P0001 Support-Schreibzugriff auf drivers kann nicht protokolliert werden, weil die Support-Sitzung nicht mehr besteht%');

  PERFORM set_config('sw.forge', 'not-a-uuid', true);
  PERFORM _sw_ok('forgery: a malformed flag fails the write too',
    _sw_try(u_adm, s_adm, v_sql) LIKE 'ERR P0001 Support-Schreibzugriff auf drivers kann nicht protokolliert werden und wird abgelehnt.');

  PERFORM set_config('sw.forge', '', true);
  PERFORM _sw_ok('forgery: with nothing forged, the member''s write goes through as before',
    _sw_try(u_adm, s_adm, v_sql) = 'rows 1');
END $$;

DROP TRIGGER _sw_forge ON public.drivers;
DROP FUNCTION _sw_forge();

/*
  A SECURITY DEFINER function writing a row past RLS as the calling account —
  which is what the planning RPCs are. Sections 10 and 11 use it to stand for a
  call whose session changes under it, which cannot be staged inside one real
  call here.
*/
CREATE FUNCTION _sw_definer_write() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
BEGIN
  UPDATE drivers SET name = 'SW after expiry' WHERE id = _sw_id('driver:x1');
END $$;

-- ─── 10. cascades: the company's own are recorded, a company delete is refused ─
--
-- A delete inside a support session cascades. Within the company it stays in
-- audited tables of that company and the session survives it, so every
-- cascaded row is recorded. A company's hard delete is refused before any
-- cascade runs (the migration header, "A company is not hard-deleted while a
-- context is open").
--
-- The two probes in the middle pin what the first version of this migration
-- got wrong. It cleared the flag when the session it named was gone and armed
-- it only while the session was valid, so a company's hard delete — which
-- deletes the session through its foreign key — closed the gate on every
-- audited cascade that ran after the session's own: those rows were written
-- with nothing recorded and nothing refused, and whether any cascade ran before
-- it depended on the order PostgreSQL chose. Each probe takes the session away
-- directly and shows the write is refused, not let through.

DO $$
DECLARE
  co_x    constant uuid := _sw_id('company:x');
  u_o     constant uuid := _sw_id('user:owner');
  s_o     constant uuid := _sw_id('session:owner');
  u_adm   constant uuid := _sw_id('user:admin-x');
  -- seed.sql's platform owner: no sign-in session, so no context at all
  u_super constant uuid := '50000000-0000-4000-8000-000000000001';
  v_ctx   constant uuid := _sw_owner_context();
  v_mark  bigint;
  v_out   text;
  v_rows  bigint;
  v_n     bigint;
BEGIN
  -- A driver with a note and a salary, written as the database owner, so none
  -- of it is audited.
  INSERT INTO drivers (id, company_id, name) VALUES (_sw_id('driver:cascade'), co_x, 'SW cascade');
  INSERT INTO driver_notes (id, created_by, driver_id, note_text, company_id)
  VALUES (_sw_id('note:cascade'), u_adm, _sw_id('driver:cascade'), 'sw', co_x);
  INSERT INTO salaries (id, company_id, driver_id, period_start, period_end, created_by)
  VALUES (_sw_id('salary:cascade'), co_x, _sw_id('driver:cascade'), '2026-02-01', '2026-02-28', u_adm);

  v_mark := _sw_mark();
  PERFORM _sw_as(u_o, s_o);
  DELETE FROM drivers WHERE id = _sw_id('driver:cascade');
  PERFORM _sw_reset();

  PERFORM _sw_ok('cascade: deleting a driver records the driver and each row the delete cascaded into',
    _sw_rows(v_mark) = 3
    AND _sw_rows(v_mark, 'support_write.drivers.delete') = 1
    AND _sw_rows(v_mark, 'support_write.driver_notes.delete') = 1
    AND _sw_rows(v_mark, 'support_write.salaries.delete') = 1);
  PERFORM _sw_ok('cascade: …all of them in the company the session is on, under the session',
    NOT EXISTS (SELECT 1 FROM app_private.platform_audit_log l
                 WHERE l.id > v_mark
                   AND (l.company_id IS DISTINCT FROM co_x
                        OR (l.after_value ->> 'context_id') IS DISTINCT FROM v_ctx::text)));

  -- The session disappears under a flag this account armed — what a company's
  -- hard delete does to it through the foreign key. The gate must stay open
  -- for this account, so the write is refused rather than let through. Taken
  -- apart inside a subtransaction that is rolled back, session included.
  BEGIN
    PERFORM _sw_as(u_o, s_o);
    UPDATE drivers SET name = name WHERE id = _sw_id('driver:x1');
    PERFORM _sw_reset();
    DELETE FROM app_private.platform_company_contexts WHERE id = v_ctx;
    PERFORM _sw_as(u_o, s_o);
    PERFORM _sw_definer_write();
    v_out := 'written, with nothing refused';
    RAISE EXCEPTION USING ERRCODE = 'ZZ010';
  EXCEPTION
    WHEN SQLSTATE 'ZZ010' THEN NULL;
    WHEN OTHERS THEN v_out := SQLSTATE || ' ' || SQLERRM;
  END;
  PERFORM _sw_reset();
  PERFORM _sw_ok(format('vanished session: a write after the session was deleted mid-transaction is refused, not let through (%s)', v_out),
    v_out LIKE 'P0001 Support-Schreibzugriff auf drivers kann nicht protokolliert werden, weil die Support-Sitzung nicht mehr besteht%');

  -- The session ends before the first write of a transaction, as when another
  -- transaction closes it between a planning RPC resolving its company and
  -- writing. Nothing is armed yet; the account still reaches the audit, as
  -- `none:`, and is refused.
  BEGIN
    PERFORM set_config('app_private.support_write_context', '', true);
    UPDATE app_private.platform_company_contexts
       SET closed_at = now(), closed_reason = 'manual'
     WHERE id = v_ctx;
    PERFORM _sw_as(u_o, s_o);
    PERFORM _sw_definer_write();
    v_out := 'written, with nothing refused';
    RAISE EXCEPTION USING ERRCODE = 'ZZ010';
  EXCEPTION
    WHEN SQLSTATE 'ZZ010' THEN NULL;
    WHEN OTHERS THEN v_out := SQLSTATE || ' ' || SQLERRM;
  END;
  PERFORM _sw_reset();
  PERFORM _sw_ok(format('ended session: a platform account''s write with no support session open is refused, not let through (%s)', v_out),
    v_out LIKE 'P0001 Schreibzugriff eines Plattform-Kontos auf drivers ohne offene Support-Sitzung wird abgelehnt.');
  PERFORM _sw_ok('ended session: …and both probes rolled back, the session included',
    _sw_owner_context() = v_ctx);

  -- A company's hard delete is decided before any of its cascades runs, by the
  -- guard on companies, so the answer no longer depends on their order.
  PERFORM _sw_ok('hard delete: the company the session is on is refused, before any cascade',
    _sw_try(u_o, s_o, format('DELETE FROM companies WHERE id = %L', co_x))
      = 'ERR P0001 Solange ein Unternehmenszugriff offen ist, kann kein Unternehmen gelöscht werden. Bitte zuerst den Zugriff beenden.');
  PERFORM _sw_ok('hard delete: …and so is any other company',
    _sw_try(u_o, s_o, format('DELETE FROM companies WHERE id = %L', _sw_id('company:y')))
      = 'ERR P0001 Solange ein Unternehmenszugriff offen ist, kann kein Unternehmen gelöscht werden. Bitte zuerst den Zugriff beenden.');

  -- An owner with no context: the D13 residual, deleted and recorded nowhere.
  BEGIN
    v_mark := _sw_mark();
    PERFORM _sw_as(u_super, NULL);
    DELETE FROM companies WHERE id = _sw_id('company:y');
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    PERFORM _sw_reset();
    v_n := _sw_rows(v_mark);
    v_out := 'ok';
    RAISE EXCEPTION USING ERRCODE = 'ZZ010';
  EXCEPTION
    WHEN SQLSTATE 'ZZ010' THEN NULL;
    WHEN OTHERS THEN v_out := SQLSTATE || ' ' || SQLERRM;
  END;
  PERFORM _sw_reset();
  PERFORM _sw_ok(format('hard delete: an owner with no context still deletes a company, and nothing is recorded as a support write (%s, rows %s, audit %s)', v_out, v_rows, v_n),
    v_out = 'ok' AND v_rows = 1 AND v_n = 0);
  PERFORM _sw_ok('hard delete: the probes rolled back — the session and both companies are still there',
    _sw_owner_context() = v_ctx
    AND (SELECT count(*) FROM companies WHERE id IN (co_x, _sw_id('company:y'))) = 2);
END $$;

-- ─── 11. a session that ends mid-call keeps its writes recorded ─────────────
--
-- A planning RPC resolves its company once and goes on writing after the
-- session's sixty minutes run out mid-call. That cannot be staged inside one
-- call here, so it is taken apart: the owner arms the flag, the context
-- expires, and _sw_definer_write() — standing for a planning RPC — writes a
-- row past RLS as the same owner.

DO $$
DECLARE
  u_o   constant uuid := _sw_id('user:owner');
  s_o   constant uuid := _sw_id('session:owner');
  v_ctx uuid := _sw_owner_context();
  v_mark bigint;
  v_rows bigint;
  r      app_private.platform_audit_log%ROWTYPE;
BEGIN
  PERFORM _sw_as(u_o, s_o);
  UPDATE drivers SET name = name WHERE id = _sw_id('driver:x1');
  PERFORM _sw_reset();

  UPDATE app_private.platform_company_contexts
     SET opened_at = now() - interval '61 minutes', expires_at = now() - interval '1 minute'
   WHERE id = v_ctx;

  PERFORM _sw_as(u_o, s_o);
  UPDATE drivers SET name = 'SW direct after expiry' WHERE id = _sw_id('driver:x1');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  PERFORM _sw_reset();
  PERFORM _sw_ok('mid-call: after the expiry a direct write reaches nothing — RLS no longer answers the company',
    v_rows = 0);
  PERFORM _sw_ok('mid-call: …and the same account''s statement left its flag in place',
    current_setting('app_private.support_write_context', true) = v_ctx::text || ':' || u_o::text);

  v_mark := _sw_mark();
  PERFORM _sw_as(u_o, s_o);
  PERFORM _sw_definer_write();
  PERFORM _sw_reset();

  SELECT * INTO r FROM app_private.platform_audit_log l WHERE l.id > v_mark;
  PERFORM _sw_ok('mid-call: a write that still happens is recorded under the session that began it',
    _sw_rows(v_mark) = 1
    AND r.actor_user_id = u_o
    AND (r.after_value ->> 'context_id') = v_ctx::text
    AND (r.after_value -> 'values' ->> 'name') = 'SW after expiry');
END $$;

DROP FUNCTION _sw_definer_write();

-- ─── 12. the edge functions' door ───────────────────────────────────────────

DO $$
BEGIN
  PERFORM _sw_ok('door: platform_audit_record cannot forge a support-write row, in either category',
    _sw_try(_sw_id('user:owner'), _sw_id('session:owner'),
            'SELECT platform_audit_record(''write'', ''support_write.drivers.update'', ''ok'')::text') LIKE 'ERR 22023%'
    AND _sw_try(_sw_id('user:owner'), _sw_id('session:owner'),
            'SELECT platform_audit_record(''support'', ''support_write.drivers.update'', ''ok'')::text') LIKE 'ERR 22023%');
END $$;

-- ─── 13. the whole file ─────────────────────────────────────────────────────

DO $$
DECLARE
  u_o constant uuid := _sw_id('user:owner');
  s_o constant uuid := _sw_id('session:owner');
BEGIN
  PERFORM _sw_ok('file: support-write rows were written',
    EXISTS (SELECT 1 FROM app_private.platform_audit_log l WHERE l.action ~ '^support_write\.'));
  PERFORM _sw_ok('file: every one of them names the owner, its role, its session and its one support context',
    NOT EXISTS (SELECT 1 FROM app_private.platform_audit_log l
                 WHERE l.action ~ '^support_write\.'
                   AND (l.actor_user_id IS DISTINCT FROM u_o
                        OR l.actor_role IS DISTINCT FROM 'owner'
                        OR l.session_id IS DISTINCT FROM s_o
                        OR l.category IS DISTINCT FROM 'support'
                        OR (l.after_value ->> 'context_id') IS DISTINCT FROM (
                             SELECT c.id::text FROM app_private.platform_company_contexts c
                              WHERE c.staff_user_id = u_o AND c.mode = 'support'))));
  PERFORM _sw_ok('file: no company member and no read-only account is the actor of any',
    NOT EXISTS (SELECT 1 FROM app_private.platform_audit_log l
                 WHERE l.action ~ '^support_write\.'
                   AND l.actor_user_id IN (_sw_id('user:admin-x'), _sw_id('user:readonly'))));
END $$;

DO $$ BEGIN RAISE NOTICE '── support-write audit: all checks passed ──'; END $$;

ROLLBACK;
